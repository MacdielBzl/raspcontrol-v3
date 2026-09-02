import WebSocket from 'ws';
import config from './config.js';
import logger from './logger.js';
import db from './db.js';
import controller from './controller.js';

let ws = null;
let isConnecting = false;
let registered = false;
let reconnectDelay = config.RECONNECT_INITIAL_DELAY;
let heartbeatInterval = null;
let heartbeatTimeout = null;
let connectTimeout = null;
let commandCallback = null;
let reconnectTimer = null;

const HEARTBEAT_INTERVAL_MS = 25000;
const HEARTBEAT_ACK_TIMEOUT_MS = 12000;
const CONNECT_TIMEOUT_MS = 10000;

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
    wsClient.cleanup();

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    logger.info(`Conectando al servidor WebSocket en ${config.SERVER_WS_URL}...`, 'NET');

    try {
      ws = new WebSocket(config.SERVER_WS_URL, {
        headers: {
          'x-gateway-id': config.GATEWAY_ID,
          'x-gateway-token': config.GATEWAY_TOKEN
        },
        handshakeTimeout: CONNECT_TIMEOUT_MS
      });

      // Watchdog for connection handshake
      connectTimeout = setTimeout(() => {
        if (isConnecting && (!ws || ws.readyState !== WebSocket.OPEN)) {
          logger.warn(`Tiempo de espera de conexión agotado (${CONNECT_TIMEOUT_MS}ms). Forzando reintento...`, 'NET');
          wsClient.forceReconnect();
        }
      }, CONNECT_TIMEOUT_MS + 2000);

      ws.on('open', () => {
        isConnecting = false;
        if (connectTimeout) {
          clearTimeout(connectTimeout);
          connectTimeout = null;
        }
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
        logger.error('El WebSocket encontró un error:', error.message || error, 'NET');
      });

      ws.on('pong', () => {
        if (heartbeatTimeout) {
          clearTimeout(heartbeatTimeout);
          heartbeatTimeout = null;
        }
      });

    } catch (err) {
      isConnecting = false;
      logger.error('Fallo al instanciar la conexión WebSocket.', err, 'NET');
      wsClient.cleanup();
      wsClient.scheduleReconnect();
    }
  },

  /**
   * Cleans up running intervals, timeouts, and states on disconnect.
   */
  cleanup: () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (heartbeatTimeout) {
      clearTimeout(heartbeatTimeout);
      heartbeatTimeout = null;
    }
    if (connectTimeout) {
      clearTimeout(connectTimeout);
      connectTimeout = null;
    }
  },

  /**
   * Forcibly destroys the active socket and triggers a clean reconnection.
   */
  forceReconnect: () => {
    logger.warn('Forzando terminación de socket zombi y reconexión inmediata...', 'NET');
    wsClient.cleanup();
    registered = false;
    isConnecting = false;
    
    if (ws) {
      try {
        ws.removeAllListeners();
        ws.terminate();
      } catch (err) {
        logger.debug('Error terminando socket:', err);
      }
      ws = null;
    }

    wsClient.scheduleReconnect();
  },

  /**
   * Schedules a connection retry with exponential backoff.
   */
  scheduleReconnect: () => {
    if (reconnectTimer) return;
    
    logger.info(`Programando reconexión en ${reconnectDelay}ms...`, 'NET');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
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
  handleMessage: async (message) => {
    if (!message || typeof message !== 'object') return;
    const { event, data } = message;
    if (!event) return;

    logger.debug(`Evento WebSocket recibido: ${event}`, 'NET');

    switch (event) {
      case 'register_ack':
        registered = true;
        reconnectDelay = config.RECONNECT_INITIAL_DELAY;
        logger.success('Gateway registrado y autenticado con éxito en el servidor.', 'NET');
        wsClient.startHeartbeat();
        wsClient.flushOfflineTelemetry();
        break;

      case 'gateway_manifest':
        if (data) {
          logger.sync('Se recibió actualización de manifiesto del servidor.', 'NET');
          db.saveManifest(data);
          try {
            controller.run();
          } catch (ctrlErr) {
            logger.error('Error al invocar ciclo de control tras actualización de manifiesto.', ctrlErr, 'NET');
          }
        }
        break;

      case 'device_command':
        if (data && data.deviceId) {
          logger.info(`Comando de dispositivo recibido para ${data.deviceId}`, 'NET');
          if (commandCallback) {
            try {
              commandCallback(data.deviceId, data.state);
            } catch (cmdErr) {
              logger.error(`Error procesando comando para el dispositivo ${data.deviceId}:`, cmdErr, 'NET');
            }
          }
        }
        break;

      case 'heartbeat_ack':
        logger.debug('Latido de corazón de servidor reconocido.', 'NET');
        if (heartbeatTimeout) {
          clearTimeout(heartbeatTimeout);
          heartbeatTimeout = null;
        }
        break;

      default:
        logger.warn(`Evento de WebSocket no controlado recibido: ${event}`, 'NET');
    }
  },

  /**
   * Periodically sends a ping to the server with watchdog protection.
   */
  startHeartbeat: () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
    
    heartbeatInterval = setInterval(() => {
      if (wsClient.isConnected()) {
        const pingSent = wsClient.send('ping', { timestamp: new Date().toISOString() });
        if (pingSent) {
          if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
          heartbeatTimeout = setTimeout(() => {
            logger.warn(`Watchdog: Sin respuesta de heartbeat en ${HEARTBEAT_ACK_TIMEOUT_MS}ms. Conexión zombi detectada.`, 'NET');
            wsClient.forceReconnect();
          }, HEARTBEAT_ACK_TIMEOUT_MS);
        }
      } else {
        wsClient.forceReconnect();
      }
    }, HEARTBEAT_INTERVAL_MS);
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
    
    db.queueTelemetry(payload);
  },

  /**
   * Uploads energy meter telemetry data, queueing it locally if the socket is offline.
   */
  uploadEnergyTelemetry: (energyRecord) => {
    if (!energyRecord) return false;
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
   * Flushes any queued offline telemetry records to the server with rate-limiting.
   */
  flushOfflineTelemetry: async () => {
    const queued = db.getQueuedTelemetry();
    if (queued.length === 0) return;

    logger.sync(`Transmitiendo ${queued.length} registros de telemetría fuera de línea en cola...`, 'NET');
    
    let sentCount = 0;
    for (const record of queued) {
      if (!wsClient.isConnected() || !registered) break;
      
      const eventType = record.event === 'energy_telemetry' ? 'energy_telemetry' : 'telemetry_offline';
      
      const success = wsClient.send(eventType, record);
      if (success) {
        sentCount++;
        await new Promise(resolve => setTimeout(resolve, 50));
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
