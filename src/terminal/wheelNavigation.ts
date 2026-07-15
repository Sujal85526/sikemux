export interface AlternateScreenWheelGesture {
    defaultPrevented: boolean;
    bufferType: "normal" | "alternate";
    mouseTrackingMode: string;
    applicationCursorKeysMode: boolean;
    deltaX: number;
    deltaY: number;
}

export function alternateScreenWheelFallbackSequence(gesture: AlternateScreenWheelGesture): string | null {
    if (gesture.defaultPrevented || gesture.bufferType !== "alternate" || gesture.mouseTrackingMode !== "none") return null;
    if (gesture.deltaY === 0 || Math.abs(gesture.deltaY) < Math.abs(gesture.deltaX)) return null;

    const units = Math.max(1, Math.min(6, Math.ceil(Math.abs(gesture.deltaY) / 40)));
    const up = gesture.deltaY < 0;
    const sequence = gesture.applicationCursorKeysMode ? (up ? "\x1bOA" : "\x1bOB") : up ? "\x1b[A" : "\x1b[B";
    return sequence.repeat(units);
}
