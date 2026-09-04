declare module "telegram" {
  const x: any;
  export = x;
}
declare module "telegram/sessions" {
  export class StringSession {
    constructor(s: string);
  }
}
