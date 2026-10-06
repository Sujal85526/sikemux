/**
 * Which tool groups and rows in a transcript the person opened or closed, kept outside the rows
 * so a row the list recycles comes back as it was left.
 */
export class Folds {
  private open = new Map<string, boolean>();
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Whether a group or row is open; one nobody touched follows `otherwise`. */
  isOpen(id: string, otherwise: boolean): boolean {
    return this.open.get(id) ?? otherwise;
  }

  set(id: string, open: boolean) {
    this.open.set(id, open);
    this.listeners.forEach((listener) => listener());
  }
}
