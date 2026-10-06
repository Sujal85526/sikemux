import { expect, it } from 'vitest';

import { openVectorInSwift, swiftAvailable } from './notifyVector.mjs';

it.skipIf(!swiftAvailable)(
  "opens the core's sealed vector the way the iPhone's notification extension does",
  () => {
    expect(openVectorInSwift()).toBe('ok');
  },
  120_000,
);
