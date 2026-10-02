export interface Message {
  version: number;
  type: string;
  id: string;
  timestamp: number;
  payload: any;
}

export interface TextPayload {
  text: string;
}
