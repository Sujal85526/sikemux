import { requireOptionalNativeModule } from 'expo';

type BackgroundTimeModule = {
  begin(name: string): Promise<number>;
  end(id: number): Promise<void>;
};

/** iOS only: Android keeps running a moment after the app leaves the screen without being asked. */
const native = requireOptionalNativeModule<BackgroundTimeModule>('SikemuxBackgroundTime');

/** Runs `work`, asking iOS not to suspend the app until it is done, for as long as iOS allows. */
export async function inBackgroundTime<T>(name: string, work: () => Promise<T>): Promise<T> {
  const held = await native?.begin(name).catch(() => undefined);
  try {
    return await work();
  } finally {
    if (held !== undefined) native?.end(held).catch(() => {});
  }
}
