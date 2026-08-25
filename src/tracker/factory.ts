import type { TrackerConfig } from '../config.js'
import { TrelloTracker } from '../trello/tracker.js'
import { YouGileTracker } from '../yougile/tracker.js'
import type { TaskTracker } from './types.js'

/** The one place that maps TRACKER=… to an implementation. */
export function createTracker(cfg: TrackerConfig): TaskTracker {
  return cfg.tracker === 'yougile' ? new YouGileTracker(cfg) : new TrelloTracker(cfg)
}
