import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from .env (override: true forces reload over PM2's cached environment)
dotenv.config({ path: path.join(__dirname, '.env'), override: true });

const config = {
  // Identity & Auth
  GATEWAY_ID: process.env.GATEWAY_ID || 'demo-gateway',
  GATEWAY_TOKEN: process.env.GATEWAY_TOKEN || 'demo-token',
  
  // Server connection
  SERVER_WS_URL: process.env.SERVER_WS_URL || 'ws://localhost:3000/api/device/control',
  
  // Hardware settings
  HARDWARE_MODE: process.env.HARDWARE_MODE || 'MOCK', // MOCK or NATIVE
  
  // File Paths for offline caching
  JSON_DB_PATH: path.join(__dirname, 'db_store_v3.json'),
  
  // Timezone settings
  TIMEZONE: process.env.TIMEZONE || 'America/Mexico_City',
  DATE_TIME_FORMAT: 'YYYY-MM-DD HH:mm:ss',
  TIME_FORMAT: 'HH:mm:ss',
  
  // Log configuration
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  
  // Reconnection options
  RECONNECT_INITIAL_DELAY: 1000, // ms
  RECONNECT_MAX_DELAY: 30000,    // ms
  RECONNECT_BACKOFF_FACTOR: 1.5,
  
  // Intervals
  TELEMETRY_INTERVAL_MS: 30000,  // 30 seconds (for local testing; use 300000 in production)
  CONTROL_LOOP_INTERVAL_MS: 10000, // 10 seconds
  ENERGY_INTERVAL_MS: parseInt(process.env.ENERGY_INTERVAL_MS, 10) || 60000, // 60 seconds (1 minute)
  MANIFEST_SYNC_INTERVAL_MS: parseInt(process.env.MANIFEST_SYNC_INTERVAL_MS, 10) || 300000, // 5 minutes (300 seconds)

  // OneWire Sensors Settings (Optimizado a 1 muestra rápida con CRC y reintento)
  ONEWIRE_SAMPLES: parseInt(process.env.ONEWIRE_SAMPLES, 10) || 1,
  ONEWIRE_SAMPLE_DELAY_MS: parseInt(process.env.ONEWIRE_SAMPLE_DELAY_MS, 10) || 100,
  ONEWIRE_MAX_ATTEMPTS: parseInt(process.env.ONEWIRE_MAX_ATTEMPTS, 10) || 2
};

export default config;
