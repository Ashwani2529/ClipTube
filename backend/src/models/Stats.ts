import { Schema, model } from 'mongoose';

/** Single-document collection; `key` is pinned so there can only ever be one row. */
const statsSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: 'global' },
    totalDownloads: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true },
);

export const Stats = model('Stats', statsSchema);

const GLOBAL_KEY = 'global';

/**
 * Atomically bumps the all-time counter and returns the new total. Called when a clip
 * job is created (i.e. when the user presses Download), so retries and failures are
 * still counted — this is the behaviour the product spec asks for.
 */
export async function incrementDownloadCount(by = 1): Promise<number> {
  const doc = await Stats.findOneAndUpdate(
    { key: GLOBAL_KEY },
    { $inc: { totalDownloads: by }, $setOnInsert: { key: GLOBAL_KEY } },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
  ).lean();

  return doc?.totalDownloads ?? 0;
}

export async function getDownloadCount(): Promise<number> {
  const doc = await Stats.findOne({ key: GLOBAL_KEY }).lean();
  return doc?.totalDownloads ?? 0;
}
