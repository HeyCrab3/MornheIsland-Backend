import log4js from 'log4js'
import path from 'path'
import { config } from '../config.js'; 

type LoggerType = 'info' | 'warn' | 'error' | 'fatal' | undefined
type CatType = 'auth' | 'access' | 'routes' | 'whitelist' | 'default'

const fileName = path.join(config.log_path, `log${new Date().getFullYear()}${new Date().getMonth() + 1}${new Date().getDate()}-${new Date().getHours()}${new Date().getMinutes()}${new Date().getSeconds()}.log`)

log4js.configure({
  appenders: { sky: { type: "file", filename: fileName }, console: { "type": "console" }, access: { type: "file", filename: path.join(config.log_path, 'access_log', `access${new Date().toISOString().split('T')[0]}.log`) }, },
  categories: {
    auth: { appenders: ["sky", "console"], level: "info" },
    access: { appenders: ["sky", "console", "access"], level: "info" },
    routes: { appenders: ["sky", "console"], level: "info" },
    whitelist: { appenders: ["sky", "console"], level: "info" },
    default: { appenders: ["sky", "console"], level: "info" }
  }
});

const log = (message: any, type: LoggerType = 'info', category: CatType = 'default') => {
  const logger = log4js.getLogger(category);
  switch (type) {
    case 'info':
      logger.info(message);
      break;
    case 'warn':
      logger.warn(message);
      break;
    case 'error':
      logger.error(message);
      break;
    case 'fatal':
      logger.fatal(message);
      break;
    default:
      logger.info(message);
  }
}

export { log }
