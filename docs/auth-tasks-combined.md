# Auth Flow — Combined Issue

## Issue

**Title:** Auth flow — login, validation, logout, and role-based redirect

**Acceptance Criteria:**

**Login — valid credentials**
- User navigates to /login and sees the CareSync sign-in form
- User fills in a valid email and password and clicks Sign In
- User is redirected to /dashboard
- A welcome message with the user's first name is visible
- The sidebar shows the user's full name and role

**Login — invalid credentials**
- User submits with a wrong password — an error message is shown and there is no redirect
- User submits with a non-existent email — an error message is shown and there is no redirect
- The email field retains its value after a failed attempt
- The password field is cleared after a failed attempt

**Login — empty fields**
- User clicks Sign In with both fields empty — validation errors appear on both fields
- User clicks Sign In with only email filled — a password validation error appears
- User clicks Sign In with only password filled — an email validation error appears

**Logout**
- Authenticated user clicks the logout button in the sidebar
- User is redirected to /login
- Navigating to /dashboard while logged out redirects back to /login

**Role-based redirect**
- A patient logs in and lands on /dashboard with patient-specific content visible
- An admin logs in and lands on /dashboard with admin-specific content visible
- Each role sees only the navigation items relevant to their role in the sidebar

**Feature:** auth
**QA Environment URL:** https://app.testingwithekki.com
**Output Repo:** klikagent-demo-tests
