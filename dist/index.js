import createDebugLogger from 'debug';
import { EventEmitter } from 'node:events';
import format from 'pg-format';
import pg from 'pg';
const connectionLogger = createDebugLogger('pg-listen:connection');
const notificationLogger = createDebugLogger('pg-listen:notification');
const paranoidLogger = createDebugLogger('pg-listen:paranoid');
const subscriptionLogger = createDebugLogger('pg-listen:subscription');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const connect = (connectionConfig, options) => {
  connectionLogger('Creating PostgreSQL client');
  const { retryInterval = 500, retryLimit = Infinity, retryTimeout = 3000 } = options;
  const effectiveConnectionConfig = { ...connectionConfig, keepAlive: true };
  const Client = options.native && pg.native ? pg.native.Client : pg.Client;
  const dbClient = new Client(effectiveConnectionConfig);
  const getRetryInterval =
    typeof retryInterval === 'function' ? retryInterval : () => retryInterval;
  const reconnect = async (onAttempt) => {
    connectionLogger('Reconnecting to PostgreSQL');
    const startTime = Date.now();
    for (let attempt = 1; attempt < retryLimit || !retryLimit; attempt++) {
      connectionLogger(`PostgreSQL reconnection attempt #${attempt}...`);
      onAttempt(attempt);
      try {
        const newClient = new Client(effectiveConnectionConfig);
        const connecting = new Promise((resolve, reject) => {
          newClient.once('connect', resolve);
          newClient.once('end', () => reject(Error('Connection ended')));
          newClient.once('error', reject);
        });
        await Promise.all([newClient.connect(), connecting]);
        connectionLogger('PostgreSQL reconnection succeeded');
        return newClient;
      } catch (error) {
        connectionLogger('PostgreSQL reconnection attempt failed:', error);
        await delay(getRetryInterval(attempt - 1));
        if (retryTimeout && Date.now() - startTime > retryTimeout) {
          throw new Error(
            `Stopping PostgreSQL reconnection attempts after ${retryTimeout}ms timeout has been reached`,
          );
        }
      }
    }
    throw new Error('Failed to reconnect to database');
  };
  return {
    dbClient,
    reconnect,
  };
};
const extractErrorMessage = (error) =>
  error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message
    : null;
const extractError = (context, error) => {
  if (error instanceof Error) {
    return error;
  }
  const message = extractErrorMessage(error);
  if (message) {
    return new Error(`${context}: ${message}`);
  }
  return new Error(`${context}: ${error}`);
};
const forwardDBNotificationEvents = (dbClient, emitter, parse) => {
  const onNotification = (notification) => {
    let payload;
    try {
      payload = notification.payload ? parse(notification.payload) : undefined;
    } catch (error) {
      return emitter.emit(
        'error',
        extractError('Error parsing PostgreSQL notification payload', error),
      );
    }
    emitter.emit('notification', {
      processId: notification.processId,
      channel: notification.channel,
      payload,
    });
  };
  dbClient.on('notification', onNotification);
  return () => {
    dbClient.removeListener('notification', onNotification);
  };
};
function scheduleParanoidChecking(dbClient, intervalTime, reconnect) {
  const scheduledCheck = async () => {
    try {
      await dbClient.query('SELECT pg_backend_pid()');
      paranoidLogger('Paranoid connection check ok');
    } catch (error) {
      paranoidLogger('Paranoid connection check failed');
      connectionLogger('Paranoid connection check failed:', error);
      await reconnect();
    }
  };
  const interval = setInterval(scheduledCheck, intervalTime);
  return () => {
    clearInterval(interval);
  };
}
export const createSubscriber = (connectionConfig, options = {}) => {
  const { paranoidChecking = 30000, parse = JSON.parse, serialize = JSON.stringify } = options;
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0); // unlimited listeners
  const notificationsEmitter = new EventEmitter();
  notificationsEmitter.setMaxListeners(0); // unlimited listeners
  emitter.on('notification', (notification) => {
    notificationsEmitter.emit(notification.channel, notification.payload);
  });
  const { dbClient: initialDBClient, reconnect } = connect(connectionConfig, options);
  let closing = false;
  let dbClient = initialDBClient;
  let reinitializingRightNow = false;
  let subscribedChannels = new Set();
  let cancelEventForwarding = () => undefined;
  let cancelParanoidChecking = () => undefined;
  const initialize = (client) => {
    // Wire the DB client events to our exposed emitter's events
    cancelEventForwarding = forwardDBNotificationEvents(client, emitter, parse);
    dbClient.on('error', (error) => {
      if (!reinitializingRightNow) {
        connectionLogger('DB Client error:', error);
        reinitialize();
      }
    });
    dbClient.on('end', () => {
      if (!reinitializingRightNow) {
        connectionLogger('DB Client connection ended');
        reinitialize();
      }
    });
    if (paranoidChecking) {
      cancelParanoidChecking = scheduleParanoidChecking(client, paranoidChecking, reinitialize);
    }
  };
  // No need to handle errors when calling `reinitialize()`, it handles its errors itself
  const reinitialize = async () => {
    if (reinitializingRightNow || closing) {
      return;
    }
    reinitializingRightNow = true;
    try {
      cancelParanoidChecking();
      cancelEventForwarding();
      dbClient.removeAllListeners();
      dbClient.once('error', (error) =>
        connectionLogger(`Previous DB client errored after reconnecting already:`, error),
      );
      dbClient.end();
      dbClient = await reconnect((attempt) => emitter.emit('reconnect', attempt));
      initialize(dbClient);
      const subscribedChannelsArray = Array.from(subscribedChannels);
      if (subscriptionLogger.enabled) {
        subscriptionLogger(`Re-subscribing to channels: ${subscribedChannelsArray.join(', ')}`);
      }
      await Promise.all(
        subscribedChannelsArray.map((channelName) =>
          dbClient.query(`LISTEN ${format.ident(channelName)}`),
        ),
      );
      emitter.emit('connected');
    } catch (error) {
      connectionLogger('Caught an error while reinitializing:', error);
      emitter.emit(
        'error',
        extractError(
          'Re-initializing the PostgreSQL notification client after connection loss failed',
          error,
        ),
      );
    } finally {
      reinitializingRightNow = false;
    }
  };
  // TODO: Maybe queue outgoing notifications while reconnecting
  return {
    /** Emits events: "error", "notification" & "redirect" */
    events: emitter,
    /** For convenience: Subscribe to distinct notifications here, event name = channel name */
    notifications: notificationsEmitter,
    /** Don't forget to call this asynchronous method before doing your thing */
    async connect() {
      initialize(dbClient);
      await dbClient.connect();
      emitter.emit('connected');
    },
    close() {
      connectionLogger('Closing PostgreSQL notification listener');
      closing = true;
      cancelParanoidChecking();
      return dbClient.end();
    },
    getSubscribedChannels() {
      return Array.from(subscribedChannels);
    },
    listenTo(channelName) {
      if (subscribedChannels.has(channelName)) {
        return;
      }
      subscriptionLogger(`Subscribing to PostgreSQL notification "${channelName}"`);
      subscribedChannels.add(channelName);
      return dbClient.query(`LISTEN ${format.ident(channelName)}`);
    },
    notify(channelName, payload) {
      notificationLogger(`Sending PostgreSQL notification to "${channelName}":`, payload);
      if (payload !== undefined) {
        const serialized = serialize(payload);
        return dbClient.query(`NOTIFY ${format.ident(channelName)}, ${format.literal(serialized)}`);
      } else {
        return dbClient.query(`NOTIFY ${format.ident(channelName)}`);
      }
    },
    unlisten(channelName) {
      if (!subscribedChannels.has(channelName)) {
        return;
      }
      subscriptionLogger(`Unsubscribing from PostgreSQL notification "${channelName}"`);
      subscribedChannels.delete(channelName);
      return dbClient.query(`UNLISTEN ${format.ident(channelName)}`);
    },
    unlistenAll() {
      subscriptionLogger('Unsubscribing from all PostgreSQL notifications');
      subscribedChannels = new Set();
      return dbClient.query(`UNLISTEN *`);
    },
  };
};
