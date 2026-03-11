Initialize a new project using the PACT framework.

First, read the CLAUDE.md file to understand the PACT framework and your role as orchestrator.

Then, ask the user for the following information to fill in the PROJECT CONFIGURATION section of CLAUDE.md:

1. **Project Overview**: What does this project do? What problem does it solve?
2. **Technology Stack**: What technologies will be used? (Framework, language, database, etc.)
3. **Project Structure**: What will the directory structure look like?
4. **Development Commands**: What commands will be used for dev, build, test, etc.?
5. **Environment Variables**: What environment variables are needed?

After gathering this information:
1. Update the PROJECT CONFIGURATION section in CLAUDE.md with the provided details
2. Update codebase-context.md with the project summary and architecture overview
3. Create the docs/preparation and docs/architecture folders if they don't exist
4. Provide a summary of the initialized project and suggest next steps (typically starting the Prepare phase)
