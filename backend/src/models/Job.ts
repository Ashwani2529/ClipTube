import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

export const JOB_STATUSES = [
  'queued',
  'downloading',
  'processing',
  'ready',
  'downloaded',
  'failed',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const CLIP_TYPES = ['video', 'audio'] as const;
export type ClipType = (typeof CLIP_TYPES)[number];

const jobSchema = new Schema(
  {
    /** Public id used in the status/download URLs (a uuid, not the Mongo _id). */
    jobId: { type: String, required: true, unique: true, index: true },

    url: { type: String, required: true },
    videoId: { type: String, required: true },
    title: { type: String, default: '' },

    /** Clip bounds in seconds from the start of the source video. */
    start: { type: Number, required: true, min: 0 },
    end: { type: Number, required: true, min: 0 },

    type: { type: String, enum: CLIP_TYPES, required: true },
    formatId: { type: String, required: true },

    status: { type: String, enum: JOB_STATUSES, default: 'queued', index: true },
    /** 0–100 while yt-dlp runs; stays at 100 once the file is written. */
    progress: { type: Number, default: 0, min: 0, max: 100 },

    /** Absolute path on disk; cleared once the file has been served and unlinked. */
    filePath: { type: String, default: null },
    /** Name presented to the browser: `{slug}-clip.{ext}`. */
    fileName: { type: String, default: null },
    sizeBytes: { type: Number, default: null },

    error: { type: String, default: null },
    completedAt: { type: Date, default: null },
    servedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Lets the cleanup job find jobs whose files may still be on disk.
jobSchema.index({ status: 1, createdAt: 1 });

export type JobAttributes = InferSchemaType<typeof jobSchema>;
export type JobDocument = HydratedDocument<JobAttributes>;

export const Job = model('Job', jobSchema);
