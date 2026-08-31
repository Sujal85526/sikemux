type ThemeDescriptor = {
    name: string;
    load: () => Promise<unknown>;
};

const emptyThemes = {
    getTheme: (_name: string) => undefined,
    getThemes: (): ThemeDescriptor[] => [],
};

export const pierreThemes = emptyThemes;
export const shikiThemes = emptyThemes;

export function createTheme(descriptor: ThemeDescriptor): ThemeDescriptor {
    return descriptor;
}
