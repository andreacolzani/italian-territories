/** The emitter refuses to publish (§6.12, Step 16): the world or a previous dataset is not publishable. */
export class EmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmitError';
  }
}
