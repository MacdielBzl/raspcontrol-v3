import WebSocket from 'ws';
import config from './config.js';
import logger from './logger.js';
import db from './db.js';

let ws = null;
let isConnecting = false;
let registered = false;
let reconnectDelay = config.RECONNECT_INITIAL_DELAY;
let heartbeatInterval = null;
let commandCallback = null;

export const wsClient = {
  /**
   * Register a callback to handle incoming device commands from the server.
   */
  onDeviceCommand: (callback) => {
    commandCallback = callback;
  },

  /**
   * Establishes the WebSocket connection.
   */
  connect: () => {
    if (wsClient.isConnected() || isConnecting) return;
    
    isConnecting = true;
    logger.info(`Conectando al servidor WebSocket en ${config.SERVER_WS_URL}...`, 'NET');

    try {
      ws = new WebSocket(config.SERVER_WS_URL, {
        headers: {
          'x-gateway-id': config.GATEWAY_ID,
          'x-gateway-token': config.GATEWAY_TOKEN
        }
      });

      ws.on('open', () => {
        isConnecting = false;
        logger.success('Conexión WebSocket establecida. Enviando handshake de registro...', 'NET');
        wsClient.send('register', {
          gatewayId: config.GATEWAY_ID,
          token: config.GATEWAY_TOKEN
        });
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          wsClient.handleMessage(message);
        } catch (error) {
          logger.error('Fallo al analizar el JSON del mensaje WS entrante.', error, 'NET');
        }
      });

      ws.on('close', (code, reason) => {
        isConnecting = false;
        registered = false;
        logger.warn(`Conexión WebSocket cerrada (Código: ${code}, Razón: ${reason || 'Ninguna proporcionada'}).`, 'NET');
        wsClient.cleanup();
        wsClient.scheduleReconnect();
      });

      ws.on('error', (error) => {
        isConnecting = false;
        logger.error('El WebSocket encontró un error.', error, 'NET');
        // Close event will follow and trigger reconnection
      });

    } catch (err) {
      isConnecting = false;
      logger.error('Fallo al instanciar la conexión WebSocket.', err, 'NET');
      wsClient.scheduleReconnect();
    }
  },

  /**
   * Cleans up running intervals and states on disconnect.
   */
  cleanup: () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  },

  /**
   * Schedules a connection retry with exponential backoff.
   */
  scheduleReconnect: () => {
    logger.info(`Programando reconexión en ${reconnectDelay}ms...`, 'NET');
    setTimeout(() => {
      // Adjust backoff delay for the next attempt
      reconnectDelay = Math.min(
        reconnectDelay * config.RECONNECT_BACKOFF_FACTOR,
        config.RECONNECT_MAX_DELAY
      );
      wsClient.connect();
    }, reconnectDelay);
  },

  /**
   * Checks if the WebSocket connection is open.
   */
  isConnected: () => {
    return ws && ws.readyState === WebSocket.OPEN;
  },

  /**
   * Helper to serialize and send JSON messages to the server.
   */
  send: (event, data) => {
    if (!wsClient.isConnected()) {
      logger.warn(`No se puede enviar el evento '${event}': El WebSocket no está conectado.`, 'NET');
      return false;
    }
    
    try {
      const payload = JSON.stringify({ event, data });
      ws.send(payload);
      logger.debug(`Evento WebSocket enviado: ${event}`, 'NET');
      return true;
    } catch (error) {
      logger.error(`Fallo al serializar/enviar el evento WebSocket: ${event}`, error, 'NET');
      return false;
    }
  },

  /**
   * Handles incoming WebSocket messages by routing them based on event type.
   */
  handleMessage: (message) => {
    const { event, data } = message;
    if (!event) return;

    logger.debug(`Evento WebSocket recibido: ${event}`, 'NET');

    switch (event) {
      case 'register_ack':
        registered = true;
        reconnectDelay = config.RECONNECT_INITIAL_DELAY; // Reset backoff delay on successful auth
        logger.success('Gateway registrado y autenticado con éxito en el servidor.', 'NET');
        wsClient.startHeartbeat();
        wsClient.flushOfflineTelemetry();
        break;

      case 'gateway_manifest':
        logger.sync('Se recibió actualización de manifiesto del servidor.', 'NET');
        db.saveManifest(data);
        break;

      case 'device_command':
        logger.info(`Comando de dispositivo recibido para ${data.deviceId}`, 'NET');
        if (commandCallback) {
          commandCallback(data.deviceId, data.state);
        }
        break;

      case 'heartbeat_ack':
        logger.debug('Latido de corazón de servidor reconocido.', 'NET');
        break;

      default:
        logger.warn(`Evento de WebSocket no controlado recibido: ${event}`, 'NET');
    }
  },

  /**
   * Periodically sends a ping to the server to maintain the connection.
   */
  startHeartbeat: () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    
    heartbeatInterval = setInterval(() => {
      if (wsClient.isConnected()) {
        wsClient.send('ping', { timestamp: new Date().toISOString() });
      }
    }, 30000); // Send ping every 30 seconds
  },

  /**
   * Uploads telemetry data, queueing it locally if the socket is offline.
   */
  uploadTelemetry: (telemetryData) => {
    const payload = {
      event: 'telemetry',
      gatewayId: config.GATEWAY_ID,
      telemetry: telemetryData,
      timestamp: new Date().toISOString()
    };

    if (wsClient.isConnected() && registered) {
      const success = wsClient.send('telemetry', payload);
      if (success) {
        logger.success('Telemetría de control subida con éxito al servidor.', 'NET');
        return;
      }
    }
    
    // Fallback: Queue offline telemetry
    db.queueTelemetry(payload);
  },

  /**
   * Uploads energy meter telemetry data, queueing it locally if the socket is offline.
   */
  uploadEnergyTelemetry: (energyRecord) => {
    const payload = {
      event: 'energy_telemetry',
      gatewayId: config.GATEWAY_ID,
      esmM: energyRecord.esmM,
      hash: energyRecord.externalId,
      data: energyRecord.data,
      timestamp: new Date().toISOString()
    };

    if (wsClient.isConnected() && registered) {
      const success = wsClient.send('energy_telemetry', payload);
      if (success) {
        logger.success(`Telemetría de medidor de energía ${energyRecord.esmM} subida con éxito.`, 'NET');
        return true;
      }
    }

    logger.warn(`Modo fuera de línea: Guardando telemetría de energía del medidor ${energyRecord.esmM} en la cola.`, 'NET');
    db.queueTelemetry(payload);
    return false;
  },

  /**
   * Flushes any queued offline telemetry records to the server.
   */
  flushOfflineTelemetry: async () => {
    const queued = db.getQueuedTelemetry();
    if (queued.length === 0) return;

    logger.sync(`Transmitiendo ${queued.length} registros de telemetría fuera de línea en cola...`, 'NET');
    
    let sentCount = 0;
    for (const record of queued) {
      if (!wsClient.isConnected()) break;
      
      // Determine the correct event (use the original event or fallback)
      const eventType = record.event === 'energy_telemetry' ? 'energy_telemetry' : 'telemetry_offline';
      
      const success = wsClient.send(eventType, record);
      if (success) {
        sentCount++;
      } else {
        break;
      }
    }

    if (sentCount > 0) {
      db.clearQueuedTelemetry(sentCount);
      logger.success(`Se transmitieron con éxito ${sentCount} registros fuera de línea.`, 'NET');
    }
  },

  /**
   * Explicitly requests an updated manifest from the server.
   */
  requestManifest: () => {
    if (wsClient.isConnected() && registered) {
      logger.debug('Solicitando manifiesto actualizado al servidor...', 'NET');
      wsClient.send('request_manifest', { timestamp: new Date().toISOString() });
    }
  }
};

export default wsClient;
