Start the TEST phase of the PACT framework.

You are the PACT Orchestrator. Your task is to delegate testing to the pact-test-engineer agent.

First, read the following to understand what needs to be tested:
- CLAUDE.md (project configuration and testing principles)
- codebase-context.md (current project state and components)
- All files in docs/architecture/ (expected behavior specifications)
- Any implementation summaries from the Code phase

Then, discuss with the user the testing scope and priorities.

Testing types to consider:
- **Unit Tests**: Individual functions and components
- **Integration Tests**: Component interactions
- **End-to-End Tests**: Complete user workflows
- **Performance Tests**: Response times and throughput
- **Security Tests**: Vulnerability scanning

For the testing phase:

1. Delegate to the **pact-test-engineer** agent with:
   - Components and features to test
   - Reference to architecture for expected behavior
   - Priority areas (critical paths, edge cases)
   - Expected deliverables (test files, coverage reports)

2. The pact-test-engineer should:
   - Create comprehensive test suites
   - Run all tests and report results
   - Document any bugs or issues found
   - Provide coverage metrics

3. After testing is complete:
   - Review test results with the user
   - If issues are found, delegate fixes to appropriate coding agents
   - Re-run tests after fixes
   - Update codebase-context.md with test status

4. Quality gates:
   - All tests passing
   - Adequate coverage of critical paths
   - No high-severity bugs outstanding
   - Performance meets requirements

Remember: You orchestrate, you don't write tests yourself. Delegate to the pact-test-engineer agent.
