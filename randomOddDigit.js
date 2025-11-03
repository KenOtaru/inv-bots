// Function to generate a random odd digit (1, 3, 5, 7, or 9)
function generateRandomOddDigit() {
    // Generate a random number between 0 and 4
    const randomIndex = Math.floor(Math.random() * 5);
    // Convert to odd digit: 1, 3, 5, 7, 9
    return randomIndex * 2 + 1;
}

// Alternative implementation using array
function generateRandomOddDigit2() {
    const oddDigits = [1, 3, 5, 7, 9];
    return oddDigits[Math.floor(Math.random() * oddDigits.length)];
}

// Usage examples
const oddDigit = generateRandomOddDigit();
console.log(`Random odd digit: ${oddDigit}`);

const oddDigit2 = generateRandomOddDigit2();
console.log(`Random odd digit (method 2): ${oddDigit2}`);

// Export functions for use in other modules
module.exports = {
    generateRandomOddDigit,
    generateRandomOddDigit2
};