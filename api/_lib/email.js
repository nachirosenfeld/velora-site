import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

// NOTE: onboarding@resend.dev can only deliver to the address that owns the
// Resend account. Until veloracapitalgrp.com is verified in Resend, notify the
// account owner's inbox. Swap NOTIFY_TO to admin@veloracapitalgrp.com once the
// sending domain is verified.
const NOTIFY_TO = 'nachirosenfeld51@gmail.com';
const FROM = 'Velora Applications <onboarding@resend.dev>';

// The notification deliberately contains NO SSN, DOB, bank data, or files —
// just enough to know an application arrived and where to review it.
export async function sendApplicationNotification({ applicationId, legalName, ownerName, fundingRequested, projectRef }) {
  const reviewUrl = `https://supabase.com/dashboard/project/${projectRef}/editor`;
  try {
    await resend.emails.send({
      from: FROM,
      to: NOTIFY_TO,
      subject: `New application: ${legalName}`,
      text: [
        `A new funding application was submitted on veloracapitalgrp.com.`,
        ``,
        `Business: ${legalName}`,
        `Owner: ${ownerName}`,
        `Funding requested: ${fundingRequested || 'n/a'}`,
        `Application ID: ${applicationId}`,
        ``,
        `Review the full application (incl. documents) in Supabase:`,
        reviewUrl,
      ].join('\n'),
    });
    return { ok: true };
  } catch (err) {
    // Non-fatal: the row is already saved. Log and move on.
    console.error('[email] notification failed:', err?.message || err);
    return { ok: false };
  }
}
