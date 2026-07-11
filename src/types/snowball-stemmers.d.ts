declare module 'snowball-stemmers' {
  export interface Stemmer {
    stem(word: string): string;
  }
  export function newStemmer(language: string): Stemmer;
  export function algorithms(): string[];
}
