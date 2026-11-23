export type ConsentContextReader = (element:Element, question:string, titles:Element[], members?:Element[]) => string | undefined;
export function annotateQuestionContext(mode:'reader'): ConsentContextReader;
export function annotateQuestionContext(): void;
