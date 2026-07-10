const PRIORITY_HIGH = "high";
const PRIORITY_MEDIUM = "medium";
const PRIORITY_LOW = "low";
const PRIORITIES = [PRIORITY_HIGH, PRIORITY_MEDIUM, PRIORITY_LOW];

const queues = {
    [PRIORITY_HIGH]: [],
    [PRIORITY_MEDIUM]: [],
    [PRIORITY_LOW]: []
};

let nextJobId = 1;

function normalizePriority(priority) {
    return PRIORITIES.includes(priority) ? priority : PRIORITY_MEDIUM;
}

function totalSize() {
    return PRIORITIES.reduce((sum, priority) => sum + queues[priority].length, 0);
}

function enqueuePersistenceJob(job = {}) {
    if (typeof job.run !== "function") {
        throw new Error("persistence job requires run()");
    }

    const priority = normalizePriority(job.priority);
    const queuedJob = {
        id: nextJobId++,
        queued_at_ms: Date.now(),
        attempts: 0,
        ...job,
        priority
    };
    queues[priority].push(queuedJob);

    return {
        job_id: queuedJob.id,
        priority,
        size: totalSize()
    };
}

function dequeuePersistenceBatch(limit = 100) {
    const max = Math.max(1, Math.trunc(Number(limit) || 100));
    const batch = [];

    for (const priority of PRIORITIES) {
        while (queues[priority].length > 0 && batch.length < max) {
            batch.push(queues[priority].shift());
        }
        if (batch.length >= max) {
            break;
        }
    }

    return batch;
}

function requeuePersistenceBatch(batch = []) {
    for (let index = batch.length - 1; index >= 0; index--) {
        const job = batch[index];
        const priority = normalizePriority(job?.priority);
        queues[priority].unshift({
            ...job,
            priority
        });
    }
}

function getPersistenceQueueStats() {
    return {
        high: queues[PRIORITY_HIGH].length,
        medium: queues[PRIORITY_MEDIUM].length,
        low: queues[PRIORITY_LOW].length,
        total: totalSize()
    };
}

function clearPersistenceQueue() {
    for (const priority of PRIORITIES) {
        queues[priority].length = 0;
    }
}

module.exports = {
    PRIORITY_HIGH,
    PRIORITY_LOW,
    PRIORITY_MEDIUM,
    clearPersistenceQueue,
    dequeuePersistenceBatch,
    enqueuePersistenceJob,
    getPersistenceQueueStats,
    requeuePersistenceBatch
};
