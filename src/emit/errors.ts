export class EmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmitError';
  }
}
