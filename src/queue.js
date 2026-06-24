import PQueue from 'p-queue';
import { config } from './config.js';

/**
 * Single shared download queue. Limits concurrent yt-dlp processes so the
 * bot stays responsive instead of spawning unbounded work.
 */
export const downloadQueue = new PQueue({ concurrency: config.concurrency });

/**
 * Add a job to the queue.
 * @template T
 * @param {() => Promise<T>} job
 * @returns {Promise<T>}
 */
export function enqueue(job) {
  return downloadQueue.add(job);
}

/**
 * How many jobs are waiting ahead (not counting running ones).
 * Useful to tell the user "you're N-th in line".
 * @returns {number}
 */
export function queuePosition() {
  return downloadQueue.size;
}
