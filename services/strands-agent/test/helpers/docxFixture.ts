/**
 * Build a real, valid .docx file in memory for tests, using the `docx` library.
 * Each supplied string becomes its own paragraph.
 */
import { Document, Packer, Paragraph, TextRun } from 'docx';

export async function makeDocx(...paragraphs: string[]): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: paragraphs.map(
          (text) => new Paragraph({ children: [new TextRun(text)] }),
        ),
      },
    ],
  });
  return Packer.toBuffer(doc);
}
