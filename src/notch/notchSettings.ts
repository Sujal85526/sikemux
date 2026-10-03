import { invokeCommand as invoke } from "../api/invoke";

/** The Notch section of the settings, which the app hands to the `sikemux-notch` helper. */
export interface NotchSettings {
    readonly enabled: boolean;
    readonly displays: "all" | "builtIn" | "pointer";
    readonly openWith: "hover" | "click";
    readonly fullScreen: "needsYou" | "always" | "never";
    readonly peeks: "all" | "needsYou" | "never";
    readonly answerInNotch: boolean;
    readonly sound: boolean;
    readonly haptics: boolean;
    readonly yieldToDev: boolean;
}

export const DEFAULT_NOTCH_SETTINGS: NotchSettings = {
    enabled: true,
    displays: "all",
    openWith: "hover",
    fullScreen: "needsYou",
    peeks: "all",
    answerInNotch: true,
    sound: true,
    haptics: true,
    yieldToDev: true,
};

function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return allowed.includes(value as T) ? (value as T) : fallback;
}

export function normaliseNotchSettings(value: unknown): NotchSettings {
    const saved = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const flag = (key: keyof NotchSettings) => (typeof saved[key] === "boolean" ? (saved[key] as boolean) : (DEFAULT_NOTCH_SETTINGS[key] as boolean));
    return {
        enabled: flag("enabled"),
        displays: choice(saved.displays, ["all", "builtIn", "pointer"], DEFAULT_NOTCH_SETTINGS.displays),
        openWith: choice(saved.openWith, ["hover", "click"], DEFAULT_NOTCH_SETTINGS.openWith),
        fullScreen: choice(saved.fullScreen, ["needsYou", "always", "never"], DEFAULT_NOTCH_SETTINGS.fullScreen),
        peeks: choice(saved.peeks, ["all", "needsYou", "never"], DEFAULT_NOTCH_SETTINGS.peeks),
        answerInNotch: flag("answerInNotch"),
        sound: flag("sound"),
        haptics: flag("haptics"),
        yieldToDev: flag("yieldToDev"),
    };
}

export const notchApi = {
    configure: (settings: NotchSettings) => invoke<void>("notch_configure", { settings }),
};
