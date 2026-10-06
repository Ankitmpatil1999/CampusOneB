/** GST invoice documents: amounts in words, place of supply, tax split and a well-formed PDF. */
import { renderInvoicePdf, type InvoiceDocumentData } from '../services/invoice-document';
import { splitTax, stateOfPin, GSTIN_PATTERN } from '../utils/gst';
import { PdfDocument, rupeesInWords } from '../utils/pdf';

describe('rupeesInWords', () => {
  it('uses the Indian system', () => {
    expect(rupeesInWords(21_240_000)).toBe('Rupees Two Lakh Twelve Thousand Four Hundred Only');
    expect(rupeesInWords(36_580)).toBe('Rupees Three Hundred Sixty Five and Eighty Paise Only');
    expect(rupeesInWords(1_23_45_67_890_00)).toBe(
      'Rupees One Hundred Twenty Three Crore Forty Five Lakh Sixty Seven Thousand Eight Hundred Ninety Only',
    );
    expect(rupeesInWords(50)).toBe('Rupees Zero and Fifty Paise Only');
  });
});

describe('place of supply', () => {
  it('reads the state from the PIN code, with the exceptions', () => {
    expect(stateOfPin('577203')?.code).toBe('29');
    expect(stateOfPin('403001')?.name).toBe('Goa');
    expect(stateOfPin('605001')?.name).toBe('Puducherry');
    expect(stateOfPin('834001')?.name).toBe('Jharkhand');
    expect(stateOfPin('800001')?.name).toBe('Bihar');
    expect(stateOfPin('248001')?.name).toBe('Uttarakhand');
    expect(stateOfPin(null)).toBeNull();
    expect(stateOfPin('12345')).toBeNull();
  });

  it('splits GST within the state and charges IGST across states', () => {
    expect(splitTax(3_240_001, '29', stateOfPin('560001'))).toEqual({
      kind: 'INTRA',
      cgst: 1_620_000,
      sgst: 1_620_001,
      igst: 0,
    });
    expect(splitTax(3_240_000, '29', stateOfPin('600001'))).toMatchObject({
      kind: 'INTER',
      igst: 3_240_000,
    });
    expect(splitTax(100, '29', null).kind).toBe('INTER');
  });

  it('checks the GSTIN shape', () => {
    expect(GSTIN_PATTERN.test('29AAACR0000A1Z5')).toBe(true);
    expect(GSTIN_PATTERN.test('29AAACR0000A1X5')).toBe(false);
  });
});

describe('PdfDocument', () => {
  it('writes a PDF whose cross-reference offsets point at the objects', () => {
    const doc = new PdfDocument('Test (one)');
    doc.text(40, 40, 'Hello (world) \\ ₹100 – done', { bold: true });
    doc.line(40, 50, 200, 50);
    doc.rect(40, 60, 100, 20, { fill: [240, 246, 247] });
    const pdf = doc.toBuffer().toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf).toContain('(Hello \\(world\\) \\\\ Rs. 100 \\226 done) Tj');
    const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe('xref');
    const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(pdf.slice(o, o + 10)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
  });

  it('measures and wraps text', () => {
    const doc = new PdfDocument();
    expect(doc.measure('MW', 10)).toBeCloseTo(17.77, 1);
    expect(doc.wrap('one two three four five', 50, 10).length).toBeGreaterThan(1);
  });
});

describe('renderInvoicePdf', () => {
  const data: InvoiceDocumentData = {
    profile: {
      legalName: 'RingPe Technologies Private Limited (example)',
      gstin: '29AAACR0000A1Z5',
      address: 'Example address, MG Road, Bengaluru, Karnataka 560001',
      stateCode: '29',
      sacCode: '998314',
      payeeName: 'RingPe Technologies',
      payeeBank: 'Example Bank',
      payeeAccountNo: '000000000000',
      payeeIfsc: 'EXMP0000001',
      example: true,
    },
    institution: {
      name: 'Tunga Valley Public School',
      identifier: 'RPETUNSHI000011026',
      address: '14, 2nd Cross, Vidyanagar, Shivamogga, Karnataka 577203',
      city: 'Shivamogga',
      pin: '577203',
    },
    invoice: {
      invoiceNo: 'INV-2026-00002',
      issuedOn: '2026-03-17',
      dueOn: '2026-04-01',
      period: '01 Apr 2026 – 31 Mar 2027',
      status: 'Due',
      amountPaise: 18_000_000,
      taxBp: 1800,
      taxPaise: 3_240_000,
      totalPaise: 21_240_000,
      paid: null,
      lines: [
        {
          description: 'Campus Plus · annual · renewal',
          quantity: 1,
          unitPricePaise: 18_000_000,
          amountPaise: 18_000_000,
        },
      ],
    },
  };

  it('prints the sample marker, the CGST/SGST split, the total in words and the bank details', () => {
    const pdf = renderInvoicePdf(data).toString('latin1');
    expect(pdf).toContain('SAMPLE - example RingPe details');
    expect(pdf).toContain('(CGST @ 9%) Tj');
    expect(pdf).toContain('(SGST @ 9%) Tj');
    expect(pdf).toContain('(Rs. 2,12,400.00) Tj');
    expect(pdf).toContain('Rupees Two Lakh Twelve Thousand Four Hundred Only');
    expect(pdf).toContain('IFSC: EXMP0000001');
    expect(pdf).toContain('Karnataka \\(29\\)');
  });

  it('charges IGST outside the supplier state and drops the marker for real details', () => {
    const pdf = renderInvoicePdf({
      ...data,
      profile: { ...data.profile, example: false },
      institution: { ...data.institution, pin: '600001' },
      invoice: { ...data.invoice, paid: { on: '2026-03-28', reference: 'SBIN826087731' } },
    }).toString('latin1');
    expect(pdf).not.toContain('SAMPLE');
    expect(pdf).toContain('(IGST @ 18%) Tj');
    expect(pdf).toContain('reference SBIN826087731');
    expect(pdf).not.toContain('Pay by bank transfer');
  });
});
