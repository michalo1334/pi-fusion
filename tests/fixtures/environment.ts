type EnvironmentPatch = Record<string, string | undefined>;

/** Apply an environment patch for one async test and restore every prior value. */
export async function withEnvironment<T>(patch: EnvironmentPatch, run: () => Promise<T> | T): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(patch)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
