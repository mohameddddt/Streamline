import { net } from 'electron'

/**
 * Windows' own answer to "is there a connection". `STREAMLINE_OFFLINE=1` forces
 * offline, to try the offline paths without pulling the cable.
 */
export const isOffline = (): boolean => process.env.STREAMLINE_OFFLINE === '1' || !net.isOnline()
