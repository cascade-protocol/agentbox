import winston from "winston";

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.timestamp({ format: "HH:mm:ss.SSS" }),
    winston.format.colorize(),
    winston.format.printf(({ level, message, timestamp, stack, ...meta }) => {
      let line = `[${timestamp}] ${level}: ${message}`;
      if (Object.keys(meta).length > 0) line += ` ${JSON.stringify(meta)}`;
      if (stack) line += `\n${stack}`;
      return line;
    }),
  ),
  transports: [
    new winston.transports.Console({
      handleExceptions: true,
      handleRejections: true,
    }),
  ],
});
