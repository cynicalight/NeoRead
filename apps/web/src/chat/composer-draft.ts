import type {
  ChatQuote,
  ImageAttachment,
  Message,
  ReaderSelection,
} from "@neoread/core";

export type ComposerQuote = ReaderSelection | ChatQuote;

export type ComposerDraft = {
  prompt: string;
  quotes: ComposerQuote[];
  images: ImageAttachment[];
};

export function restoreWithdrawnQuestion(
  draft: ComposerDraft,
  message: Message,
): ComposerDraft {
  const quotes = [...draft.quotes];
  for (const reference of message.references ?? []) {
    if (
      !quotes.some(
        (item) =>
          item.text === reference.text &&
          JSON.stringify(item.location) === JSON.stringify(reference.location),
      )
    )
      quotes.push(reference);
  }
  const images = [...draft.images];
  for (const image of message.attachments ?? []) {
    if (!images.some((item) => item.id === image.id)) images.push(image);
  }
  return {
    prompt: draft.prompt
      ? `${draft.prompt}\n\n${message.content}`
      : message.content,
    quotes,
    images,
  };
}
