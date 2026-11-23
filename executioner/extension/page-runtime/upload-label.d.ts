export function uploadLabelKind(value: string): 'resume' | 'action' | 'other';
export function createInlineUploadLabelReader(): (input: HTMLInputElement) => { title: string; filename: string } | null;
export function readUploadOwnerLabels(inputs: Element[]): {key:string|null; labels:string[]; visibleHeadings:string[]; ambiguous:boolean}[];
