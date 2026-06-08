const {
    createDailyMemory,
    createMemoryJobRun
} = require("../memory/store");

function todayDate() {
    return new Date().toISOString().slice(0, 10);
}

function readDate(value, invalidCode, field) {
    if (value === undefined || value === null) {
        return {
            ok: true,
            value: todayDate()
        };
    }

    if (typeof value === "string" && value.trim() === "") {
        return {
            ok: true,
            value: todayDate()
        };
    }

    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
        return {
            ok: true,
            value: value.trim()
        };
    }

    return {
        ok: false,
        statusCode: 400,
        code: invalidCode,
        error: `${field} must use YYYY-MM-DD format`
    };
}

async function runDailySummaryJob(dbRun, input = {}) {
    const targetDateResult = readDate(input.date ?? input.target_date, "DAILY_SUMMARY_DATE_INVALID", "date");
    if (!targetDateResult.ok) {
        return targetDateResult;
    }

    const targetDate = targetDateResult.value;
    const job = await createMemoryJobRun(dbRun, {
        job_name: "daily_summary",
        target_date: targetDate,
        status: "queued",
        input: {
            target_date: targetDate,
            mode: "llm_required",
            note: "Server records the job entry point; summary content must come from LLM or explicit user input."
        }
    });

    if (input.summary) {
        await createDailyMemory(dbRun, {
            memory_date: targetDate,
            summary: input.summary,
            status: "candidate",
            source: "daily_summary_job",
            confidence: input.confidence,
            input: {
                job_id: job.job_id
            },
            raw: input
        });
    }

    return job;
}

async function runWeeklyProfileJob(dbRun, input = {}) {
    const targetDateResult = readDate(input.week_start ?? input.target_date, "WEEKLY_PROFILE_DATE_INVALID", "week_start");
    if (!targetDateResult.ok) {
        return targetDateResult;
    }

    const targetDate = targetDateResult.value;
    return createMemoryJobRun(dbRun, {
        job_name: "weekly_profile",
        target_date: targetDate,
        status: "queued",
        input: {
            target_date: targetDate,
            mode: "llm_required",
            note: "Server records the job entry point; profile conclusions must come from LLM output, explicit user correction, or reviewed input."
        }
    });
}

module.exports = {
    runDailySummaryJob,
    runWeeklyProfileJob
};
