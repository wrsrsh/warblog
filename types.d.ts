declare module "@electron/remote" {
  interface Dialog {
    showOpenDialog(options: { properties: string[] }): Promise<{ canceled: boolean; filePaths: string[] }>;
  }
  export const dialog: Dialog;
}
