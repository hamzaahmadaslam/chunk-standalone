---
note: Synthetic example written for chunk-standalone. It is not real documentation.
---

# Backups

The backup job copies the site database and the uploads folder to object storage once a night. Each copy is a
single archive named after the date it was taken.

## Schedule

It starts at 02:00 server time and usually takes a few minutes. Large uploads folders can take longer.

## Keeping copies

As shown above, a copy is made every night. Copies older than 14 days are deleted, except the copy from the first
day of each month, which is kept for a year.

## Settings

The following settings control the job.

## Settings reference

`backup.bucket` is the storage bucket that receives the archives, and `backup.hour` changes the start time.

To change the email address for failure alerts, open Account, then Notifications. Invoices are sent to the same
address on the first of each month.
