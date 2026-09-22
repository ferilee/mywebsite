import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  slug: text('slug').unique(),
  description: text('description').notNull(),
  content: text('content'), // Markdown Case Study
  image: text('image'),
  techStack: text('tech_stack'),
  link: text('link'),
  github: text('github'),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

export const blogPosts = sqliteTable('blog_posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  slug: text('slug').notNull().unique(),
  content: text('content').notNull(), // Markdown
  category: text('category'),
  coverImage: text('cover_image'),
  tags: text('tags'),
  status: text('status').$type<'draft' | 'published'>().default('draft'),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

export const skills = sqliteTable('skills', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  category: text('category').notNull(), // e.g., 'frontend', 'backend', 'tools'
  icon: text('icon'), // Lucide icon name or image URL
});

export const experience = sqliteTable('experience', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  company: text('company').notNull(),
  role: text('role').notNull(),
  period: text('period').notNull(), // e.g., 'Jan 2022 - Present'
  description: text('description').notNull(),
});
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const milestones = sqliteTable('milestones', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  year: text('year').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  type: text('type').default('achievement'), // work, education, achievement
  icon: text('icon'),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

export const activities = sqliteTable('activities', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  slug: text('slug').notNull().unique(),
  eventDate: text('event_date').notNull(), // ISO date: YYYY-MM-DD
  endDate: text('end_date'),
  year: integer('year').notNull(),
  location: text('location'),
  organizer: text('organizer'),
  role: text('role').notNull(),
  category: text('category').notNull(),
  summary: text('summary').notNull(),
  description: text('description'), // Markdown
  coverImage: text('cover_image'),
  galleryAlbumUrl: text('gallery_album_url'),
  materialUrl: text('material_url'),
  materialAvailableFrom: integer('material_available_from', { mode: 'timestamp' }),
  materialAvailableUntil: integer('material_available_until', { mode: 'timestamp' }),
  certificateUrl: text('certificate_url'),
  certificateAvailableFrom: integer('certificate_available_from', { mode: 'timestamp' }),
  certificateAvailableUntil: integer('certificate_available_until', { mode: 'timestamp' }),
  publicationUrl: text('publication_url'),
  publicationAvailableFrom: integer('publication_available_from', { mode: 'timestamp' }),
  publicationAvailableUntil: integer('publication_available_until', { mode: 'timestamp' }),
  featuredOnCv: integer('featured_on_cv', { mode: 'boolean' }).default(false),
  status: text('status').$type<'draft' | 'published'>().default('draft'),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

export const activityMedia = sqliteTable('activity_media', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  activityId: integer('activity_id').notNull().references(() => activities.id),
  url: text('url').notNull(),
  caption: text('caption'),
  sortOrder: integer('sort_order').default(0),
  mediaType: text('media_type').default('image'),
});

export const activityLinks = sqliteTable('activity_links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  activityId: integer('activity_id').notNull().references(() => activities.id),
  label: text('label').notNull(),
  url: text('url').notNull(),
  availableFrom: integer('available_from', { mode: 'timestamp' }),
  availableUntil: integer('available_until', { mode: 'timestamp' }),
  sortOrder: integer('sort_order').default(0),
});

export const participantWorks = sqliteTable('participant_works', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  activityId: integer('activity_id').notNull().references(() => activities.id),
  title: text('title').notNull(),
  participantName: text('participant_name').notNull(),
  institution: text('institution'),
  description: text('description'),
  previewImage: text('preview_image'),
  workUrl: text('work_url'),
  tags: text('tags'),
  status: text('status').$type<'draft' | 'published'>().default('draft'),
  consent: integer('consent', { mode: 'boolean' }).default(false),
  sortOrder: integer('sort_order').default(0),
  viewCount: integer('view_count').default(0),
  submittedAt: integer('submitted_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

export const participantWorkReactions = sqliteTable('participant_work_reactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workId: integer('work_id').notNull().references(() => participantWorks.id),
  visitorKey: text('visitor_key').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

export const contacts = sqliteTable('contacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  subject: text('subject'),
  message: text('message').notNull(),
  isRead: integer('is_read').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

export const comments = sqliteTable('comments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  postId: integer('post_id').notNull().references(() => blogPosts.id),
  parentId: integer('parent_id'), // To support threaded comments
  name: text('name').notNull(),
  email: text('email').notNull(),
  picture: text('picture'),
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

export const reactions = sqliteTable('reactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  postId: integer('post_id').notNull().references(() => blogPosts.id),
  userEmail: text('user_email').notNull(),
  type: text('type').notNull(), // 'like', 'love', 'fire', 'rocket'
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

export const subscriptions = sqliteTable('subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

export const profiles = sqliteTable('profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  fullName: text('full_name').notNull(),
  province: text('province').notNull(),
  regency: text('regency').notNull(),
  district: text('district').notNull(),
  occupation: text('occupation').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});

export const pageViews = sqliteTable('page_views', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  path: text('path').notNull().unique(),
  count: integer('count').default(0),
  lastViewed: integer('last_viewed', { mode: 'timestamp' }).$defaultFn(() => new Date()),
});
