/**
 * An EventTarget that knows its events. `target.on('rooms', (detail) => detail.rooms)` is checked
 * by the compiler: a wrong event name does not compile, and `detail` has the right shape.
 *
 * It still IS an EventTarget (addEventListener keeps working), and every event is a CustomEvent
 * whose `detail` is the payload, so tests and older code that listen the classic way are fine.
 */
export class TypedEventTarget<M extends object> extends EventTarget {
  emit<K extends keyof M & string>(name: K, detail: M[K]): void {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  /** Returns the function that unsubscribes. */
  on<K extends keyof M & string>(name: K, listener: (detail: M[K]) => void): () => void {
    const handler = (event: Event): void => {
      // A CustomEvent dispatched by emit(); anything else with this name is not ours.
      if (event instanceof CustomEvent) listener(event.detail as M[K]); // detail was typed by emit()
    };
    this.addEventListener(name, handler);
    return () => this.removeEventListener(name, handler);
  }
}
