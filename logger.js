import moment from 'moment-timezone';
import config from './config.js';

const colors = {
  reset: '\x1b[0m',
  info: '\x1b[34m',     // Blue
  success: '\x1b[32m',  // Green
  warn: '\x1b[33m',     // Yellow
  error: '\x1b[31m',    // Red
  sync: '\x1b[36m',     // Cyan
  hw: '\x1b[35m',       // Magenta
  dim: '\x1b[2m'        // Dim/Gray
};

const levels = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

const currentLevel = levels[config.LOG_LEVEL.toLowerCase()] ?? levels.info;

function formatTimestamp() {
  return moment().tz(config.TIMEZONE).format('YYYY-MM-DD HH:mm:ss.SSS');
}

export const logger = {
  debug: (message, context = '') => {
    if (currentLevel <= levels.debug) {
      console.log(`${colors.dim}[${formatTimestamp()}] [DEPURACIÓN]${context ? ` [${context}]` : ''} ${message}${colors.reset}`);
    }
  },
  
  info: (message, context = '') => {
    if (currentLevel <= levels.info) {
      console.log(`${colors.info}[${formatTimestamp()}] [INFO]${context ? ` [${context}]` : ''} ${message}${colors.reset}`);
    }
  },
  
  success: (message, context = '') => {
    if (currentLevel <= levels.info) {
      console.log(`${colors.success}[${formatTimestamp()}] [ÉXITO]${context ? ` [${context}]` : ''} ${message}${colors.reset}`);
    }
  },
  
  warn: (message, context = '') => {
    if (currentLevel <= levels.warn) {
      console.warn(`${colors.warn}[${formatTimestamp()}] [ADVERTENCIA]${context ? ` [${context}]` : ''} ${message}${colors.reset}`);
    }
  },
  
  error: (message, error = null, context = '') => {
    if (currentLevel <= levels.error) {
      const errMsg = error ? `: ${error.stack || error.message || error}` : '';
      console.error(`${colors.error}[${formatTimestamp()}] [ERROR]${context ? ` [${context}]` : ''} ${message}${errMsg}${colors.reset}`);
    }
  },
  
  sync: (message, context = '') => {
    if (currentLevel <= levels.info) {
      console.log(`${colors.sync}[${formatTimestamp()}] [SINCRONIZACIÓN]${context ? ` [${context}]` : ''} ${message}${colors.reset}`);
    }
  },
  
  hw: (message, context = '') => {
    if (currentLevel <= levels.info) {
      console.log(`${colors.hw}[${formatTimestamp()}] [HARDWARE]${context ? ` [${context}]` : ''} ${message}${colors.reset}`);
    }
  }
};

export default logger;
