import { db } from './index';
import { projects, skills, experience, blogPosts } from './schema';

async function seed() {
  console.log('Seeding data...');

  // Projects
  await db.insert(projects).values([
    {
      title: 'IdeTech Platform',
      description: 'A multi-role dashboard for students, teachers, and admins with game-like aesthetics.',
      techStack: 'Next.js, Tailwind CSS, Drizzle ORM, PostgreSQL',
      link: 'https://idetech.io',
    },
    {
      title: 'Gamer Portal',
      description: 'Community platform for gamers featuring news, tournaments, and social integration.',
      techStack: 'React, Hono, Bun, SQLite',
      link: 'https://gamer.ferilee.dev',
    }
  ]).onConflictDoNothing();

  // Skills
  await db.insert(skills).values([
    { name: 'React', category: 'Frontend' },
    { name: 'TypeScript', category: 'Languages' },
    { name: 'Hono', category: 'Backend' },
    { name: 'Bun', category: 'Backend' },
    { name: 'Tailwind CSS', category: 'Frontend' },
    { name: 'Drizzle ORM', category: 'Database' },
    { name: 'Git', category: 'Tools' },
  ]).onConflictDoNothing();

  // Experience
  await db.insert(experience).values([
    {
      company: 'Digital Solutions Inc.',
      role: 'Senior Fullstack Developer',
      period: '2022 - Present',
      description: 'Leading the development of complex web applications using modern stacks.',
    },
    {
      company: 'Creative Studio',
      role: 'Frontend Developer',
      period: '2020 - 2022',
      description: 'Focused on high-fidelity UI/UX implementations.',
    }
  ]).onConflictDoNothing();

  // Blog
  await db.insert(blogPosts).values([
    {
      title: 'Building Lightweight Apps with Hono and Bun',
      slug: 'building-lightweight-apps-hono-bun',
      content: 'In this article, we explore why Hono and Bun are the perfect match for performance-critical applications...',
      category: 'Tech',
      status: 'published',
    }
  ]).onConflictDoNothing();

  console.log('Seeding completed!');
}

seed().catch(console.error);
