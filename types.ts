export interface Note {
  id: string;
  type: 'tip' | 'qa' | 'context';
  content: string;
  question?: string;
  topic?: string;
}

export interface SessionRecord {
  id: string;
  title: string;
  date: number; // Stored as a timestamp
  transcription: string;
  notes: Note[];
  report: string;
}
