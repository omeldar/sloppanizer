/** Current time; injectable so tests can move it. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

export const isoNow = (clock: Clock): string => clock().toISOString();
