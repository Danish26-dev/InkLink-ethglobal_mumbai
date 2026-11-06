/** Jobs started in this browser tab (same lifetime as the anonymous session). */
import type { PaymentHandoff } from '@inklink/shared-schemas';

const JOBS_KEY = 'inklink.web.jobs';
const HANDOFF_KEY = (jobId: string) => `inklink.web.handoff.${jobId}`;

export interface RecentJob {
  jobId: string;
  shopId: string;
  shopName: string;
  createdAt: string;
}

export function recentJobs(): RecentJob[] {
  try {
    return JSON.parse(sessionStorage.getItem(JOBS_KEY) ?? '[]') as RecentJob[];
  } catch {
    return [];
  }
}

export function rememberJob(job: RecentJob) {
  const list = [job, ...recentJobs().filter((j) => j.jobId !== job.jobId)].slice(0, 20);
  sessionStorage.setItem(JOBS_KEY, JSON.stringify(list));
}

export function savedHandoff(jobId: string): PaymentHandoff | null {
  try {
    const h = JSON.parse(sessionStorage.getItem(HANDOFF_KEY(jobId)) ?? 'null') as PaymentHandoff | null;
    return h && new Date(h.expiresAt).getTime() > Date.now() ? h : null;
  } catch {
    return null;
  }
}

export function saveHandoff(h: PaymentHandoff | null, jobId: string) {
  if (h) sessionStorage.setItem(HANDOFF_KEY(jobId), JSON.stringify(h));
  else sessionStorage.removeItem(HANDOFF_KEY(jobId));
}
