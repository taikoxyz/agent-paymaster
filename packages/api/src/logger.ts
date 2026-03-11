export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export const logEvent = (level: LogLevel, event: string, fields: LogFields = {}): void => {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  };

  const serialized = JSON.stringify(payload);

  if (level === "error") {
    console.error(serialized);
    return;
  }

  if (level === "warn") {
    console.warn(serialized);
    return;
  }

  console.log(serialized);
};
