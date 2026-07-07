// Ambient type declaration for email-reply-parser v1.x (CJS, no shipped types).
// The real package exports EmailReplyParser as module.exports (CJS default).
// With esModuleInterop + allowSyntheticDefaultImports, the default import works.
declare module 'email-reply-parser' {
  class Fragment {
    isHidden(): boolean;

    isSignature(): boolean;

    isQuoted(): boolean;

    getContent(): string;

    isEmpty(): boolean;

    toString(): string;
  }

  class Email {
    getFragments(): Fragment[];

    getVisibleText(): string;

    getQuotedText(): string;
  }

  class EmailReplyParser {
    read(text: string): Email;

    parseReply(text: string): string;

    parseReplied(text: string): string;
  }

  export = EmailReplyParser;
}
