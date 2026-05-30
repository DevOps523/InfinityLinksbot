export type AsyncMutex = {
  run<T>(operation: () => Promise<T>): Promise<T>;
};

export function createAsyncMutex(): AsyncMutex {
  let tail: Promise<void> = Promise.resolve();

  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });

      await previous;
      try {
        return await operation();
      } finally {
        release();
      }
    }
  };
}
