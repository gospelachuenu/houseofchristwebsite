// contact.js - Express backend for contact form
import express from 'express';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import nodemailer from 'nodemailer';

import dotenv from 'dotenv';
dotenv.config();

const router = express.Router();

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// POST /api/contact
router.post('/', async (req, res) => {
  const { name, email, wants_contact, message, captchaToken } = req.body;

  // Basic validation
  if (!name || !email || !message || typeof wants_contact === 'undefined' || !captchaToken) {
    return res.status(400).json({ success: false, error: 'Missing required fields.' });
  }

  // Verify reCAPTCHA v3
  try {
    const captchaRes = await axios.post(
      `https://www.google.com/recaptcha/api/siteverify`,
      null,
      {
        params: {
          secret: process.env.RECAPTCHA_SECRET_KEY,
          response: captchaToken,
        },
      }
    );
    if (!captchaRes.data.success || captchaRes.data.score < 0.5) {
      return res.status(400).json({ success: false, error: 'reCAPTCHA failed. Please try again.' });
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: 'reCAPTCHA verification error.' });
  }

  // Save to Supabase database
  try {
    const { data, error } = await supabase
      .from('contact_messages')
      .insert([
        {
          name,
          email,
          wants_contact,
          message,
          created_at: new Date().toISOString(),
        },
      ]);
    if (error) {
      return res.status(500).json({ success: false, error: 'Database error: ' + error.message });
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Database error.' });
  }

  // Send email notification
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    await transporter.sendMail({
      from: `Contact Form <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_TO,
      subject: 'New Contact Form Submission',
      text: `Name: ${name}\nEmail: ${email}\nWants Contact: ${wants_contact}\nMessage: ${message}`,
      html: `<h2>New Contact Form Submission</h2>
             <p><b>Name:</b> ${name}</p>
             <p><b>Email:</b> ${email}</p>
             <p><b>Wants Contact:</b> ${wants_contact}</p>
             <p><b>Message:</b><br>${message.replace(/\n/g, '<br>')}</p>`
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to send notification email.' });
  }

  // Respond success
  return res.json({ success: true });
});

export default router; 