import { GutterContainer } from './gutter-container';

/**
 * The transcript stream container. Kept as a named subclass so call sites
 * read semantically; behavior is plain `GutterContainer`.
 */
export class TranscriptContainer extends GutterContainer {}
