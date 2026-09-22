import { describe, expect, it, mock } from "bun:test";
import { app } from "../src/index";

// Mock the database to avoid real DB hits during unit tests
mock.module("../src/db/index", () => {
  const mockQuery = {
    from: () => mockQuery,
    where: () => mockQuery,
    orderBy: () => mockQuery,
    limit: () => mockQuery,
    values: () => mockQuery,
    set: () => mockQuery,
    onConflictDoUpdate: () => Promise.resolve(),
    onConflictDoNothing: () => Promise.resolve(),
    then: (resolve: any) => resolve([{ 
      id: 1, 
      title: "Test", 
      slug: "test", 
      content: "Content", 
      status: "published",
      name: "Test User",
      participantName: "Test Participant",
      activityId: 1,
      workUrl: "https://example.com/work",
      consent: true,
      viewCount: 2,
      createdAt: new Date(),
      techStack: "React, Node",
      sum: 100
    }])
  };

  return {
    db: {
      select: () => mockQuery,
      insert: () => mockQuery,
      update: () => mockQuery,
      delete: () => mockQuery,
    }
  };
});

describe("Public API Endpoints", () => {
  it("GET /healthz returns a successful health response", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("GET /api/projects returns projects list", async () => {
    const res = await app.request("/api/projects");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data[0].title).toBe("Test");
  });

  it("GET /api/blog returns published posts", async () => {
    const res = await app.request("/api/blog");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it("GET /api/skills returns skills list", async () => {
    const res = await app.request("/api/skills");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it("GET /api/activities returns published activities", async () => {
    const res = await app.request("/api/activities");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  it("GET /api/search with query returns results", async () => {
    const res = await app.request("/api/search?q=test");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("projects");
    expect(data).toHaveProperty("blog");
  });
});

describe("Main Pages", () => {
  it("GET / returns 200 OK", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
  });

  it("GET /projects returns 200 OK", async () => {
    const res = await app.request("/projects");
    expect(res.status).toBe(200);
  });

  it("GET /blog returns 200 OK", async () => {
    const res = await app.request("/blog");
    expect(res.status).toBe(200);
  });

  it("GET /contact returns 200 OK", async () => {
    const res = await app.request("/contact");
    expect(res.status).toBe(200);
  });

  it("GET /jejak returns 200 OK", async () => {
    const res = await app.request("/jejak");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("text-justify");
    expect(html).toContain("/api/og?title=Test");
  });

  it("GET /jejak/:slug renders justified details and social sharing options", async () => {
    const res = await app.request("/jejak/test");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("prose-p:text-justify");
    expect(html).toContain('data-share-link="whatsapp"');
    expect(html).toContain("navigator.share");
    expect(html).toContain("Salin tautan");
    expect(html).toContain("grid-cols-2");
    expect(html).toContain("col-span-2");
  });

  it("GET /jejak/karya renders the participant showcase", async () => {
    const res = await app.request("/jejak/karya?category=AI&sort=applause");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("KARYA");
    expect(html).toContain("data-showcase-view=\"list\"");
    expect(html).toContain("Paling diapresiasi");
    expect(html).toContain('name="category"');
    expect(html).toContain('name="sort"');
  });

  it("POST /api/participant-works/:id/applause returns the applause count", async () => {
    const res = await app.request("/api/participant-works/1/applause", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applause: 1, reacted: true });
    expect(res.headers.get("set-cookie")).toContain("work_reaction_key=");
  });

  it("GET /jejak/:slug/kirim-karya renders the simple submission form", async () => {
    const res = await app.request("/jejak/test/kirim-karya");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="participantName"');
    expect(html).toContain('name="consent"');
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toContain('name="previewImageFile"');
    expect(html).toContain("Bukti karya");
    expect(html).not.toContain('name="assignment"');
  });

  it("GET /jejak/karya/:id/buka tracks and redirects to a published work", async () => {
    const res = await app.request("/jejak/karya/1/buka");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://example.com/work");
  });

  it("POST /jejak/:slug/kirim-karya requires a work URL or preview image", async () => {
    const form = new FormData();
    form.set("participantName", "Test Participant");
    form.set("title", "Test Work");
    form.set("consent", "on");
    const res = await app.request("/jejak/test/kirim-karya", { method: "POST", body: form });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=evidence");
  });

  it("GET /timeline redirects to the Jejak module", async () => {
    const res = await app.request("/timeline");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/jejak");
  });
});

describe("Admin Access Control", () => {
  it("GET /admin/login uses the focused admin shell", async () => {
    const res = await app.request("/admin/login");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("AUTHENTICATE");
    expect(html).toContain("FERILEE");
    expect(html).not.toContain('href="/projects"');
  });

  it("GET /admin redirects to login when not authenticated", async () => {
    const res = await app.request("/admin");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/admin/login");
  });

  it("GET /admin uses the admin shell without public navigation", async () => {
    const session = encodeURIComponent(JSON.stringify({
      email: "admin@example.com",
      name: "Admin User",
      role: "admin",
    }));
    const res = await app.request("/admin", {
      headers: { Cookie: `user_session=${session}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Admin workspace");
    expect(html).toContain('href="/admin/activities"');
    expect(html).toContain('href="/admin/inbox"');
    expect(html).not.toContain('href="/projects"');
    expect(html).not.toContain('href="/jejak"');
    expect(html).not.toContain("INBOX MESSAGES");
    expect(html).not.toContain("JEJAK ACTIVITIES");
  });

  it("GET /admin/activities and /admin/inbox are standalone admin pages", async () => {
    const session = encodeURIComponent(JSON.stringify({
      email: "admin@example.com",
      name: "Admin User",
      role: "admin",
    }));
    const headers = { Cookie: `user_session=${session}` };

    const activitiesRes = await app.request("/admin/activities", { headers });
    expect(activitiesRes.status).toBe(200);
    expect(await activitiesRes.text()).toContain("Jejak Activities | Admin");

    const inboxRes = await app.request("/admin/inbox", { headers });
    expect(inboxRes.status).toBe(200);
    const inboxHtml = await inboxRes.text();
    expect(inboxHtml).toContain("Inbox | Admin");
    expect(inboxHtml).toContain('aria-label="Inbox sections"');
    expect(inboxHtml).toContain('id="inbox-comments"');
  });

  it("GET /admin/activities/new exposes RustFS gallery upload and album link fields", async () => {
    const session = encodeURIComponent(JSON.stringify({
      email: "admin@example.com",
      name: "Admin User",
      role: "admin",
    }));
    const res = await app.request("/admin/activities/new", {
      headers: { Cookie: `user_session=${session}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="galleryFiles"');
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).toContain("otomatis WebP");
    expect(html).toContain('name="galleryAlbumUrl"');
    expect(html).toContain("Google Photos Album URL");
    expect(html).toContain('name="activityLinkLabel"');
    expect(html).toContain('name="activityLinkUrl"');
    expect(html).toContain("addActivityLink");
  });

  it("GET /admin/works/new exposes participant work moderation fields", async () => {
    const session = encodeURIComponent(JSON.stringify({
      email: "admin@example.com",
      name: "Admin User",
      role: "admin",
    }));
    const res = await app.request("/admin/works/new", {
      headers: { Cookie: `user_session=${session}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="participantName"');
    expect(html).toContain('name="previewImageFile"');
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).toContain("otomatis WebP");
    expect(html).toContain("Pending review");
  });
});

describe("POST Endpoints", () => {
  it("POST /blog/:id/comment redirects back (unauthorized)", async () => {
    const res = await app.request("/blog/1/comment", {
      method: "POST",
      body: JSON.stringify({ content: "Great post!" })
    });
    expect(res.status).toBe(302);
  });

  it("POST /blog/:id/react redirects back (unauthorized)", async () => {
    const res = await app.request("/blog/1/react", {
      method: "POST",
      body: JSON.stringify({ type: "like" })
    });
    expect(res.status).toBe(302);
  });

  it("POST /subscribe redirects with success", async () => {
    const res = await app.request("/subscribe", {
      method: "POST",
      body: "email=test@example.com",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("subscribed=1");
  });

  it("POST /contact/send redirects with success", async () => {
    const res = await app.request("/contact/send", {
      method: "POST",
      body: "name=Test&email=test@example.com&subject=Hello&message=World",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("success=1");
  });

  it("POST /api/profile/save redirects back (unauthorized)", async () => {
    const res = await app.request("/api/profile/save", {
      method: "POST",
      body: JSON.stringify({ fullName: "Test User" })
    });
    expect(res.status).toBe(302);
  });
});
