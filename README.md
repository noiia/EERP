# EERP

This Project aims to create a new OpenSource light, modular and efficient ERP. The main part of the work is on the core section. The `modules` folder aims to mock modules for the first part and then to host the reel modules. While the core is in building, the modules will stay mocks, once the first version of the core is released, the team will start modules development.  
---

## 🧰 Requirements

- Go **1.25+**
- Git
- Docker
- Internet (To rebuild)

---

## 🚀 Getting Started

Clone the repository:

```bash
git clone https://github.com/noiia/wasm_micro_orm_poc.git
```
Install dependencies:
```bash
go mod tidy
```
Run the project:
```
make run 
```
Rebuild and run the project:
```
make rebuild-and-run 
```
Run tests:
```bash
make test
```
---
## 📁 Project Structure
This project follows standard Go project layout conventions:
```bash
.
├── core/  
│   ├── cmd/            # Application entry points
│   │   └── app/
│   │       └── main.go
│   ├── internal/       # Private application code
│   ├── pkg/            # Public reusable packages
│   ├── configs/        # Configuration files
│   ├── scripts/        # Helper scripts
│   ├── go.mod
│   ├── go.sum
│   └── schema.sql
│   
├── modules/
├── .gitignore
├── Makefile
├── README.md
├── TODO.md
├── compose.yml
└── eerp-config.json
```
### Rules:

`cmd/` contains only main packages.

`internal/` is preferred for business logic.

Avoid circular dependencies.

Keep packages small and focused.
---
## 🧠 Go Code Style Guidelines

This project follows idiomatic Go conventions:

### Formatting

Always run:
```bash
gofmt -w .
```
No manual formatting.

### Naming

- Use camelCase for variables and functions.
- Use PascalCase for exported identifiers.
- Keep names short but meaningful.

Avoid stuttering:

`❌ user.UserService`

`✅ user.Service`

### Error Handling

- Errors are values — handle them explicitly.
- Return errors as the last return value.
- Wrap errors with context when needed:

`return fmt.Errorf("failed to load config: %w", err)`
### Comments

Exported identifiers must have comments.

Comments should start with the name of the thing they describe.
```bash
// Server represents the HTTP server.
type Server struct {}
```
### Interfaces

Define interfaces where they are used, not where they are implemented.

Prefer small interfaces and Bento box style.

### Testing

Tests live in `*_test.go` files.

Table-driven tests are preferred.

Use `t.Helper()` for helpers.

Avoid testing implementation details.
---
## 🧪 Testing Conventions

Test names should be descriptive:
```bash
func TestUserService_CreateUser(t *testing.T)
```
Use subtests:
```bash
t.Run("invalid email", func(t *testing.T) {})
```
---
## 🐛 Issues Guidelines

⚠️ Before opening an issue:
- Search existing issues.
- Use the appropriate issue template.
- Provide clear reproduction steps.
- Attach logs, screenshots, or code snippets when relevant.

Issue titles should be:
- Short
- Actionable
- Descriptive

Templates are enabled depending on your necessity (feature, improvement, bug), when you create a new issue, begin by typing `/template` in the description and select the one that fits bests for your situation.

Please contact the team if you need a custom template.

```bash
<type>(optional scope): <description>
```
Examples:

`bug(config): panic when config file is missing`

`feat(security): add JWT authentication`

`docs(installation): clarify installation steps`

---
## 🧾 Commit Message Convention

This project uses Conventional Commits (GitHub-friendly).

### Format
```bash
<type>(optional scope): <description>
```
### Types
```bash
feat – new feature
```
```bash
fix – bug fix
```
```bash
docs – documentation only
```
```bash
style – formatting, no logic change
```
```bash
refactor – code change without feature/fix
```
```bash
test – tests only
```
```bash
chore – tooling, CI, deps, etc
```
### Examples
```bash
feat(auth): add JWT token validation
fix(config): handle missing config file
docs(readme): update setup instructions
refactor(user): simplify repository interface
```
### Rules:
- Use present tense
- No capital letter at the beginning
- No trailing period
- Keep it under ~72 characters
---
## 🤝 Contributing

### Fork the repository

Create a feature branch:
```bash
git checkout -b feat/my-feature
```
Commit using the convention above

Open a Pull Request
