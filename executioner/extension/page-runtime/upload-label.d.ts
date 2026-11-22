export function uploadLabelKind(value: string): 'resume' | 'action' | 'other';
export function readUploadOwnerLabels(inputs: Element[]): {key:string|null; labels:string[]; visibleHeadings:string[]; ambiguous:boolean}[];
