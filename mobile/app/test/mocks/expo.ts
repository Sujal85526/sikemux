/** No native modules run in tests, so every optional one is absent, as on a platform that lacks it. */
export const requireOptionalNativeModule = (_name: string): null => null;
